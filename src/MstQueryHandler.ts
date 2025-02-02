import equal from '@wry/equality';
import { makeObservable, observable, action } from 'mobx';
import {
    addDisposer,
    getSnapshot,
    getType,
    IAnyType,
    IDisposer,
    Instance,
    isStateTreeNode,
    onSnapshot,
} from 'mobx-state-tree';
import { merge } from './merge';
import { QueryClient } from './QueryClient';
import { QueryStatus } from './utilityTypes';
import { getSnapshotOrData } from './utils';

type QueryReturn<T extends IAnyType, TResult> = {
    data: Instance<T>['data'];
    error: any;
    result: TResult;
};

type Context = {
    fetchOptions?: {
        signal: AbortSignal;
    };
    [key: string]: any;
};

type QueryOptions = {
    request?: any;
    pagination?: any;
    context?: Context;
    convert?: (result: any) => any;
};

export type QueryFnType = (options: QueryOptions, query: any) => Promise<any>;

export class DisposedError extends Error {}

export class MstQueryHandler {
    isLoading = false;
    isRefetching = false;
    isFetchingMore = false;
    isFetched = false;
    error: any = null;

    status = QueryStatus.Active;
    result: any;
    options: any;
    model: any;
    type: any;
    queryClient!: QueryClient<any>;

    disposer?: IDisposer;
    onRequestSnapshotDisposer?: IDisposer;
    abortController?: AbortController;
    toBeRemovedTimeout?: number;

    cachedQueryFn: any;
    cachedAt?: Date;
    cachedRequest: any;

    isDisposed = false;

    constructor(model: any) {
        this.model = model;
        this.type = getType(model) as any;

        makeObservable(this, {
            isLoading: observable,
            isRefetching: observable,
            isFetchingMore: observable,
            isFetched: observable,
            error: observable,
            updateData: action.bound,
            setResult: action.bound,
            setError: action.bound,
            run: action.bound,
            query: action.bound,
            mutate: action.bound,
            queryMore: action.bound,
            refetch: action.bound,
            remove: action.bound,
            abort: action.bound,
            updateDataFromSnapshot: action.bound,
        });
    }

    init(options: any = {}) {
        this.options = options;
        this.queryClient = options.queryClient;

        if (isStateTreeNode(this.model.request)) {
            this.onRequestSnapshotDisposer =
                options.onRequestSnapshot &&
                onSnapshot(this.model.request, options.onRequestSnapshot);
        }
    }

    run(queryFn: QueryFnType, options: QueryOptions = {}, useCache = false) {
        this.cachedQueryFn = queryFn;

        this.abortController = new AbortController();

        if (!this.disposer) {
            this.disposer = addDisposer(this.model, () => this.onDispose());
        }

        const getCachedData = useCache && !this.isRefetching;
        const cachedResult = getCachedData ? this.getDataFromCache() : null;
        if (cachedResult) {
            // Update data before user call next to render cached result immediately
            this.updateDataFromSnapshot(cachedResult.data, cachedResult.cachedAt);
        }

        let promise;
        if (cachedResult && cachedResult.status !== QueryStatus.Stale) {
            promise = Promise.resolve({ __mst_query_cached: true, ...cachedResult });
        } else {
            this.isLoading = true;
            this.error = null;

            const opts = {
                ...options,
                context: {
                    fetchOptions: {
                        signal: this.abortController.signal,
                    },
                    ...options?.context,
                },
            };
            promise = queryFn(opts, this.model);
        }

        return promise
            .then((result: any) => {
                if (this.isDisposed) {
                    throw new DisposedError();
                }
                if (options.convert) {
                    return options.convert(result);
                }
                return result;
            })
            .finally(() => {
                if (cachedResult?.query.__MstQueryHandler.toBeRemovedTimeout) {
                    this.queryClient.queryStore.removeQuery(cachedResult.query);
                    clearTimeout(cachedResult.query.__MstQueryHandler.toBeRemovedTimeout);
                }
            });
    }

    query(
        queryFn: QueryFnType,
        options: QueryOptions = {}
    ): Promise<<TData extends IAnyType, TResult = any>() => QueryReturn<TData, TResult>> {
        const opts = {
            ...getVariables(this.model),
            ...options,
        };
        return this.run(queryFn, opts, true).then(
            (result) => this.onSuccess(result),
            (err) => this.onError(err)
        );
    }

    mutate(
        queryFn: QueryFnType,
        options: QueryOptions = {}
    ): Promise<<TData extends IAnyType, TResult = any>() => QueryReturn<TData, TResult>> {
        const opts = {
            ...getVariables(this.model),
            ...options,
        };
        return this.run(queryFn, opts).then(
            (result) => this.onSuccess(result),
            (err) => this.onError(err)
        );
    }

    queryMore(
        queryFn: QueryFnType,
        options: QueryOptions = {}
    ): Promise<<TData extends IAnyType, TResult = any>() => QueryReturn<TData, TResult>> {
        this.isFetchingMore = true;

        const opts = {
            ...getVariables(this.model),
            ...options,
        };
        return this.run(queryFn, opts).then(
            (result) => this.onSuccess(result, false),
            (err) => this.onError(err, false)
        );
    }

    refetch(...params: any) {
        this.isRefetching = true;

        return this.model.run(...params);
    }

    onSuccess(result: any, shouldUpdate = true) {
        return (): { data: any; error: any; result: any } => {
            if (this.isDisposed) {
                return { data: null, error: null, result: null };
            }

            if (result?.__mst_query_cached) {
                this.setResult(result.result);

                this.options.onSuccess?.(this.model.data, this.model);

                return { data: this.model.data, error: null, result: result.result };
            }

            this.setResult(result);

            let data;
            if (shouldUpdate) {
                data = this.updateData(result, { isLoading: false, error: null });
            } else {
                data = this.prepareData(result);
            }

            this.options.onSuccess?.(data, this.model);

            return { data, error: null, result };
        };
    }

    onError(err: any, shouldUpdate = true) {
        return (): { data: any; error: any; result: any } => {
            if (this.isDisposed) {
                return { data: null, error: null, result: null };
            }

            if (err instanceof DisposedError) {
                return { data: null, error: null, result: null };
            }

            if (shouldUpdate) {
                this.updateData(null, { isLoading: false, error: err });
            }

            this.options.onError?.(err, this.model);

            return { data: null, error: err, result: null };
        };
    }

    abort() {
        this.abortController?.abort();
        this.abortController = undefined;
    }

    setResult(result: any) {
        this.result = result;
    }

    setError(error: any) {
        this.error = error;
    }

    prepareData(data: any) {
        return merge(data, this.type.properties.data, this.queryClient.config.env, true);
    }

    getCachedQuery() {
        const req = getSnapshotOrData(this.model.request);
        const queries = this.queryClient.queryStore.findAll(
            this.type,
            (q) =>
                q.__MstQueryHandler.cachedQueryFn === this.cachedQueryFn &&
                equal(q.__MstQueryHandler.cachedRequest, req)
        );
        if (queries.length) {
            return queries
                .filter((q) => q.__MstQueryHandler.cachedAt)
                .sort((a, b) => b.cachedAt - a.cachedAt)[0];
        }
        return null;
    }

    getDataFromCache() {
        const cachedQuery: any = this.getCachedQuery();
        if (!cachedQuery) {
            return null;
        }

        const cachedData = (getSnapshot(cachedQuery) as any).data;
        const result = cachedQuery.result;
        const status = cachedQuery.__MstQueryHandler.status;
        const cachedAt = cachedQuery.__MstQueryHandler.cachedAt;

        return {
            result,
            status,
            cachedAt,
            data: cachedData,
            query: cachedQuery,
        };
    }

    updateDataFromSnapshot(snapshot: any, cachedAt: Date) {
        if (snapshot) {
            this.cachedAt = cachedAt;
            this.model.__MstQueryHandlerAction(() => {
                this.model.data = snapshot;
            });
        }
        if (!this.isFetched) {
            this.isFetched = true;
            this.options.onFetched?.(this.model.data, this.model);
        }

        return this.model.data;
    }

    updateData(data: any, status?: any) {
        if (data) {
            this.model.__MstQueryHandlerAction(() => {
                this.model.data = merge(data, this.type.properties.data, this.queryClient.config.env);
            });

            this.updateCache();
        }
        if (!this.isFetched) {
            this.isFetched = true;
            this.options.onFetched?.(this.model.data, this.model);
        }
        if (this.isRefetching) {
            this.isRefetching = false;
        }
        if (this.isFetchingMore) {
            this.isFetchingMore = false;
        }
        if (status) {
            this.error = status.error;
            this.isLoading = status.isLoading;
        }

        return this.model.data;
    }

    updateCache() {
        this.cachedAt = new Date();
        this.cachedRequest = getSnapshotOrData(this.model.request);

        if (this.options.staleTime) {
            setTimeout(() => {
                this.status = QueryStatus.Stale;
            }, this.options.staleTime * 1000);
        } else {
            this.status = QueryStatus.Stale;
        }
    }

    remove() {
        if (this.toBeRemovedTimeout) {
            return;
        }

        const cacheTimeMs = this.options.cacheTime * 1000;
        const currentDate = new Date().getTime();
        const cachedAt = this.cachedAt?.getTime() ?? 0;
        const elapsedInMs = currentDate - cachedAt;
        if (elapsedInMs < cacheTimeMs) {
            this.toBeRemovedTimeout = window.setTimeout(() => {
                this.queryClient.queryStore.removeQuery(this.model);
                this.toBeRemovedTimeout = undefined;
            }, cacheTimeMs - elapsedInMs);
        } else {
            this.queryClient.queryStore.removeQuery(this.model);
        }
    }

    onDispose() {
        this.isDisposed = true;
        this.abort();
        this.onRequestSnapshotDisposer?.();
        this.toBeRemovedTimeout && clearTimeout(this.toBeRemovedTimeout);
    }
}

function getVariables(model: any) {
    let variables: any = {};
    if (model.request) {
        variables.request = isStateTreeNode(model.request)
            ? getSnapshot(model.request)
            : model.request;
    }
    if (model.pagination) {
        variables.pagination = isStateTreeNode(model.pagination)
            ? getSnapshot(model.pagination)
            : model.pagination;
    }
    return variables;
}
