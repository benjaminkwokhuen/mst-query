import * as React from 'react';
import { types, unprotect, applySnapshot, getSnapshot } from 'mobx-state-tree';
import { createQuery, MstQueryRef, createMutation, useQuery, useSubscription } from '../src';
import { configure as configureMobx, observable, reaction, runInAction, when } from 'mobx';
import { collectSeenIdentifiers } from '../src/QueryStore';
import { merge } from '../src/merge';
import { render as r } from '@testing-library/react';
import { observer } from 'mobx-react';
import { ItemQuery } from './models/ItemQuery';
import { ListQuery } from './models/ListQuery';
import { itemData, listData } from './api/data';
import { SetDescriptionMutation } from './models/SetDescriptionMutation';
import { AddItemMutation } from './models/AddItemMutation';
import { RequestModel } from '../src/RequestModel';
import { api } from './api/api';
import { createAndCache, wait } from './utils';
import { QueryClient } from '../src/QueryClient';
import { createContext } from '../src/QueryClientProvider';
import { RootStore } from '../src/RootStore';
import { ItemSubscription } from './models/ItemSubscription';

const env = {};
const queryClient = new QueryClient({ RootStore });
const { QueryClientProvider, createOptimisticData } = createContext(queryClient);
queryClient.init(env);

const Wrapper = ({ children }: any) => {
    return (
        <QueryClientProvider client={queryClient} env={env}>
            {children}
        </QueryClientProvider>
    );
};

const render = (ui: React.ReactElement, options?: any) =>
    r(ui, {
        wrapper: Wrapper,
        ...options,
    });

beforeEach(() => {
    queryClient.queryStore.clear();
});

test('garbage collection', async () => {
    const q1 = createAndCache(ItemQuery, { request: { id: 'test' }, env: { api }, queryClient });
    const q2 = createAndCache(ItemQuery, { request: { id: 'test2' }, env: { api }, queryClient });
    const qc = createAndCache(ListQuery, { request: { id: 'test' }, env: { api }, queryClient });

    await q1.run();
    await q2.run();
    expect(queryClient.rootStore.models.size).toBe(2);

    await qc.run();
    expect(queryClient.rootStore.models.size).toBe(9);

    qc.__MstQueryHandler.updateData(null, { error: null, isLoading: false });
    q2.__MstQueryHandler.updateData(null, { error: null, isLoading: false });
    await wait();
    q2.__MstQueryHandler.updateData(itemData, { error: null, isLoading: false });
    qc.__MstQueryHandler.updateData(listData, { error: null, isLoading: false });
    await wait();
    queryClient.queryStore.removeQuery(q1);
    expect(queryClient.rootStore.models.size).toBe(9);

    queryClient.queryStore.removeQuery(qc);
    expect(queryClient.rootStore.models.size).toBe(2);

    queryClient.queryStore.removeQuery(q2);
    expect(queryClient.rootStore.models.size).toBe(0);
});

test('gc - only walk model props', () => {
    const VolatileModel = types.model({ id: types.identifier });
    const ModelA = types
        .model({
            id: types.identifier,
            modelProp: types.string,
            arr: types.late(() =>
                types.array(types.model({ id: types.identifier, b: types.maybe(types.string) }))
            ),
        })
        .volatile(() => ({
            volatileProp: VolatileModel.create({ id: '2' }),
        }));
    const idents = new Set();
    collectSeenIdentifiers(
        ModelA.create({ id: '1', modelProp: 'hey', arr: [{ id: '3' }] }),
        idents
    );
    expect(idents.size).toBe(2);
});

test('mutation updates domain model', async () => {
    const itemQuery = createAndCache(ItemQuery, {
        request: { id: 'test' },
        env: { api },
        queryClient,
    });
    await itemQuery.run();

    const setStatusMutation = createAndCache(SetDescriptionMutation, {
        request: { id: 'test', description: 'new' },
        env: { api },
        queryClient,
    });
    await setStatusMutation.run();
    expect(itemQuery.data?.description).toBe('new');
});

test('isLoading state', async () => {
    const itemQuery = createAndCache(ItemQuery, {
        request: { id: 'test' },
        env: { api },
        queryClient,
    });
    expect(itemQuery.isLoading).toBe(false);
    itemQuery.run();
    expect(itemQuery.isLoading).toBe(true);

    await when(() => !itemQuery.isLoading);
    expect(itemQuery.isLoading).toBe(false);
});

test('useQuery', (done) => {
    let loadingStates: any[] = [];
    let renders = 0;
    let result = null as any;
    const Comp = observer((props: any) => {
        const { query, isLoading } = useQuery(ItemQuery, {
            request: { id: 'test' },
            env: { api },
        });
        renders++;
        loadingStates.push(isLoading);
        result = query.__MstQueryHandler.result;
        return <div></div>;
    });
    render(<Comp />);
    setTimeout(() => {
        expect(result).not.toBe(null);
        expect(loadingStates).toStrictEqual([true, false]);
        expect(renders).toBe(2);
        done();
    }, 0);
});

test('query more - with initial result', async () => {
    const customApi = {
        ...api,
        async getItems(options: any, query: any) {
            if (!query.isFetched) {
                return listData;
            }
            return api.getItems(options);
        },
    };

    let q: any;
    const Comp = observer((props: any) => {
        const { query } = useQuery(ListQuery, {
            request: { id: 'test' },
            env: { api: customApi },
        });
        q = query;
        return <div></div>;
    });
    render(<Comp />);

    await when(() => !q.isLoading);

    await q.fetchMore();

    expect(q.data.items.length).toBe(7);
});

test('useQuery - with error', (done) => {
    let err: any = null;
    const customError = new Error();
    const apiWithError = {
        async getItem() {
            throw customError;
        },
    };
    const Comp = observer((props: any) => {
        const { error } = useQuery(ItemQuery, {
            request: { id: 'test ' },
            env: { api: apiWithError },
        });
        err = error;
        return <div></div>;
    });
    render(<Comp />);
    setTimeout(() => {
        expect(err).toEqual(customError);
        done();
    }, 0);
});

test('model with optional identifier', async () => {
    const customApi = {
        ...api,
        async getItems() {
            const data: any = {
                ...listData,
            };
            delete data.id;
            return data;
        },
    };

    let q: any;
    const Comp = observer((props: any) => {
        const { query } = useQuery(ListQuery, {
            request: { id: 'test' },
            env: { api: customApi },
        });
        q = query;
        return <div></div>;
    });
    render(<Comp />);

    await when(() => !q.isLoading);

    expect(queryClient.rootStore.models.get('ListModel:optional-1')).not.toBe(undefined);
});

test('refetching query', async () => {
    const getItem = jest.fn(() => Promise.resolve(itemData));
    const testApi = {
        ...api,
        getItem,
    };
    const itemQuery = createAndCache(ItemQuery, {
        request: { id: 'test' },
        env: { api: testApi },
        staleTime: 1,
        queryClient,
    });
    await itemQuery.run();

    const mutation = createAndCache(SetDescriptionMutation, {
        request: { id: 'test', description: 'new' },
        env: { api: testApi },
        queryClient,
    });
    await mutation.run();

    await itemQuery.refetch();

    expect(itemQuery.data?.description).toBe('Test item');
    expect(getItem).toHaveBeenCalledTimes(2);
});

test('mutation updates query (with optimistic update)', async () => {
    const listQuery = createAndCache(ListQuery, {
        request: { id: 'test' },
        env: { api },
        queryClient,
    });

    await listQuery.run();
    expect(listQuery.data?.items.length).toBe(4);

    let observeCount = 0;
    const dispose = reaction(
        () => listQuery.data?.items.map((i) => i.id),
        () => {
            observeCount++;
        }
    );

    const addItemMutation = createAndCache(AddItemMutation, {
        request: { path: 'test', message: 'testing' },
        env: { api },
        queryClient,
    });
    await addItemMutation.run();

    expect(observeCount).toBe(2);
    expect(listQuery.data?.items.length).toBe(5);

    dispose();
});

test('merge of date objects', () => {
    configureMobx({ enforceActions: 'never' });

    const ModelA = types.model({
        id: types.identifier,
        changed: types.model({
            at: types.Date,
        }),
    });
    const a = ModelA.create({
        id: 'test',
        changed: {
            at: new Date('2020-01-01'),
        },
    });
    unprotect(a);
    merge(
        {
            id: 'test',
            changed: {
                at: new Date('2020-02-02'),
            },
        },
        ModelA,
        queryClient.config.env
    );
    const result = merge(
        {
            id: 'test',
            changed: {
                at: new Date('2020-03-03'),
            },
        },
        ModelA,
        queryClient.config.env
    );
    expect((getSnapshot(result) as any).changed.at).toBe(1583193600000);

    configureMobx({ enforceActions: 'observed' });
});

test('deep update of object', () => {
    configureMobx({ enforceActions: 'never' });

    const ModelC = types.model({
        id: types.identifier,
        a: types.maybe(types.string),
    });
    const ModelB = types.model({
        a: types.maybe(types.string),
        b: types.maybe(types.string),
    });
    const ModelA = types.model({
        model: types.maybe(ModelB),
        ref: types.maybe(MstQueryRef(ModelC)),
    });

    const a = ModelA.create({}, queryClient.config.env);
    unprotect(a);
    const result = merge(
        { model: { a: 'banana' }, ref: { id: '1', a: 'fruit' } },
        ModelA,
        queryClient.config.env
    );
    applySnapshot(a, getSnapshot(result));
    const result2 = merge(
        { model: { a: 'banana', b: 'apple' }, ref: { id: '1', a: 'orange' } },
        ModelA,
        queryClient.config.env
    );
    applySnapshot(a, getSnapshot(result2));

    expect(a.model?.a).toBe('banana');
    expect(a.model?.b).toBe('apple');
    expect(a.ref?.a).toBe('orange');

    configureMobx({ enforceActions: 'observed' });
});

test('merge frozen type', () => {
    const ModelWithFrozenProp = types.model({
        id: types.string,
        frozen: types.frozen(),
    });

    const QueryModel = createQuery('FrozenQuery', {
        data: ModelWithFrozenProp,
    });
    const q = createAndCache(QueryModel, { request: { path: 'test' }, queryClient });
    q.__MstQueryHandler.updateData(
        { id: 'test', frozen: { data1: 'data1', data2: 'data2' } },
        { isLoading: false, error: null }
    );

    expect(() =>
        q.__MstQueryHandler.updateData(
            { id: 'test', frozen: { data1: 'data1', data2: 'data2' } },
            { isLoading: false, error: null }
        )
    ).not.toThrow();
});

test('replace arrays on sub properties', () => {
    const Model = types.model({
        id: types.identifier,
        prop: types.model({
            ids: types.array(types.model({ baha: types.string })),
        }),
    });

    const QueryModel = createQuery('FrozenQuery', {
        data: Model,
    });
    const q = createAndCache(QueryModel, { request: { path: 'test' }, queryClient });
    q.__MstQueryHandler.updateData(
        { id: 'test', prop: { ids: [{ baha: 'hey' }, { baha: 'hello' }] } },
        { isLoading: false, error: null }
    );
    q.__MstQueryHandler.updateData(
        { id: 'test', prop: { ids: [{ baha: 'hey2' }, { baha: 'hello2' }] } },
        { isLoading: false, error: null }
    );
    expect(q.data?.prop.ids[0].baha).toBe('hey2');
});

test('hasChanged mutation', () => {
    const Rqst = RequestModel.props({
        text: types.string,
    }).actions((self) => ({
        setText(text: string) {
            self.text = text;
        },
    }));

    const MutationModel = createMutation('Mutation', {
        request: Rqst,
    });
    const m = createAndCache(MutationModel, { request: { text: 'hi' }, queryClient });
    expect(m.request.hasChanges).toBe(false);

    m.request.setText('hello');
    expect(m.request.hasChanges).toBe(true);

    m.request.reset();
    expect(m.request.hasChanges).toBe(false);
    expect(m.request.text).toBe('hi');

    m.request.setText('hi');
    expect(m.request.hasChanges).toBe(false);

    m.request.setText('hiya');
    m.request.commit();
    expect(m.request.hasChanges).toBe(false);
});

test('merge with undefined data and union type', () => {
    const Model = types.model({
        folderPath: types.string,
        origin: types.union(types.string, types.undefined),
    });

    const QueryModel = createQuery('TestQuery', {
        data: Model,
    });
    const q = createAndCache(QueryModel, { request: { path: 'test' }, queryClient });

    expect(() =>
        q.__MstQueryHandler.updateData(
            { folderPath: 'test', origin: undefined },
            { isLoading: false, error: null }
        )
    ).not.toThrow();
});

test('findAll', () => {
    const RequestModel = types
        .model({
            path: types.string,
            text: types.string,
        })
        .actions((self) => ({
            setText(text: string) {
                self.text = text;
            },
        }));

    const MutationModel = createMutation('Mutation', {
        request: RequestModel,
    });
    const m = createAndCache(MutationModel, { request: { path: 'test', text: 'hi' }, queryClient });

    const queries = queryClient.queryStore.findAll(MutationModel, (mutation) =>
        mutation.request.text.includes('h')
    );
    expect(queries.length).toBe(1);

    const queries2 = queryClient.queryStore.findAll(MutationModel, (mutation) =>
        mutation.request.text.includes('o')
    );
    expect(queries2.length).toBe(0);
});

test('caching - item', async () => {
    configureMobx({ enforceActions: 'never' });

    const getItem = jest.fn(() => Promise.resolve(itemData));
    const testApi = {
        ...api,
        getItem,
    };

    let q: any;
    const Comp = observer((props: any) => {
        const { query } = useQuery(ItemQuery, {
            request: { id: 'test' },
            env: { api: testApi },
            cacheTime: 1,
            staleTime: 1,
        });
        q = query;
        return <div></div>;
    });

    let show = observable.box(true);
    const Wrapper = observer(() => {
        if (show.get()) {
            return <Comp />;
        }
        return null;
    });

    render(<Wrapper />);
    await when(() => !q.isLoading);

    show.set(false);
    await wait(0);
    show.set(true);

    expect(q.data.createdBy.name).toBe('Kim');
    expect(getItem).toBeCalledTimes(1);

    configureMobx({ enforceActions: 'observed' });
});

test('caching - list', async () => {
    let q1: any;
    const Comp1 = observer((props: any) => {
        const { query } = useQuery(ListQuery, {
            request: { id: 'test' },
            pagination: { offset: 0 },
            env: { api },
            staleTime: 1,
        });
        q1 = query;
        return <div></div>;
    });
    render(<Comp1 />);

    await when(() => !q1.isLoading);

    await q1.fetchMore();
    expect(q1.data.items.length).toBe(7);

    let q2: any;
    const Comp2 = observer((props: any) => {
        const { query } = useQuery(ListQuery, {
            request: { id: 'test' },
            pagination: { offset: 0 },
            env: { api },
            staleTime: 1,
        });
        q2 = query;
        return <div></div>;
    });
    render(<Comp2 />);

    await when(() => !q2.isLoading);

    expect(q1.data.items.length).toBe(7);
    expect(q2.data.items.length).toBe(7);
});

test('caching - reuse same key', async () => {
    const getItems = jest.fn(() => Promise.resolve(listData));
    const testApi = {
        ...api,
        getItems,
    };

    let id = observable.box('test');

    let q: any;
    const Comp = observer((props: any) => {
        const { query } = useQuery(ListQuery, {
            request: { id: id.get() },
            pagination: { offset: 0 },
            env: { api: testApi },
            staleTime: 1,
            key: id.get(),
        });
        q = query;
        if (q.isLoading || !q.data) {
            return <div>loading</div>;
        }
        return <div></div>;
    });

    render(<Comp />);
    await when(() => !q.isLoading);

    runInAction(() => id.set('test2'));
    await when(() => !q.isLoading);

    runInAction(() => id.set('test'));
    await when(() => !q.isLoading);

    expect(getItems).toBeCalledTimes(2);
});

test('caching - dont cache different query functions', async () => {
    let q1: any;
    const Comp1 = observer((props: any) => {
        const { query } = useQuery(ListQuery, {
            request: { id: 'test' },
            pagination: { offset: 0 },
            env: { api },
            staleTime: 1,
        });
        q1 = query;
        return <div></div>;
    });
    render(<Comp1 />);

    await when(() => !q1.isLoading);

    const differentApi = {
        getItems: jest.fn(() => Promise.resolve(listData)),
    };

    let q2: any;
    const Comp2 = observer((props: any) => {
        const { query } = useQuery(ListQuery, {
            request: { id: 'test' },
            pagination: { offset: 0 },
            env: { api: differentApi },
            staleTime: 1,
        });
        q2 = query;
        return <div></div>;
    });
    render(<Comp2 />);

    await when(() => !q2.isLoading);

    expect(differentApi.getItems).toBeCalledTimes(1);
});

test('caching - cache time', async () => {
    configureMobx({ enforceActions: 'never' });

    const getItems = jest.fn(() => Promise.resolve(listData));
    const testApi = {
        ...api,
        getItems,
    };

    let q: any;
    const Comp = observer((props: any) => {
        const { query } = useQuery(ListQuery, {
            request: { id: 'test' },
            pagination: { offset: 0 },
            env: { api: testApi },
            cacheTime: 0.01,
        });
        q = query;
        return <div></div>;
    });

    let show = observable.box(true);
    const Wrapper = observer(() => {
        if (show.get()) {
            return <Comp />;
        }
        return null;
    });

    render(<Wrapper />);
    await when(() => !q.isLoading);

    show.set(false);
    expect(q.__MstQueryHandler.isDisposed).toBe(false);

    await wait(20);

    expect(q.__MstQueryHandler.isDisposed).toBe(true);

    configureMobx({ enforceActions: 'observed' });
});

test('hook - onSuccess callback called', async () => {
    const onSuccess = jest.fn();
    const getItems = jest.fn(() => Promise.resolve(listData));
    const testApi = {
        ...api,
        getItems,
    };

    let q: any;
    const Comp = observer((props: any) => {
        const { query } = useQuery(ListQuery, {
            request: { id: 'test' },
            pagination: { offset: 0 },
            env: { api: testApi },
            cacheTime: 0.01,
            onSuccess: onSuccess,
        });
        q = query;
        return <div></div>;
    });

    render(<Comp />);
    await when(() => !q.isLoading);

    expect(onSuccess).toBeCalledTimes(1);
});

test('subscription', () => {
    const Comp = observer((props: any) => {
        useSubscription(ItemSubscription);
        return <div></div>;
    });

    render(<Comp />);
});

test('support map type', () => {
    const AmountTag = {
        Limited: 'Limited',
        Unlimited: 'Unlimited',
    };

    const AmountLimitModel = types.model('AmountLimit').props({
        tag: types.maybe(types.enumeration(Object.values(AmountTag))),
        content: types.maybeNull(
            types.map(
                types.model({
                    tag: types.enumeration(Object.values(AmountTag)),
                    content: types.maybeNull(types.string),
                })
            )
        ),
    });

    const QueryModel = createQuery('QueryWithMap', {
        data: AmountLimitModel,
    });
    const q = createAndCache(QueryModel, { queryClient });
    q.__MstQueryHandler.updateData(
        {
            tag: 'Limited',
            content: {
                native: {
                    tag: 'Limited',
                    content: '1000000',
                },
            },
        },
        { isLoading: false, error: null }
    );

    expect(q.data?.content?.get('native')?.tag).toBe('Limited');
});

test('merge with partial data', () => {
    const Model = types.model({
        id: types.string,
        a: types.string,
    });

    const QueryModel = createQuery('ModelQuery', {
        data: Model,
    });
    const q = createAndCache(QueryModel, { request: { path: 'test' }, queryClient });

    expect(() =>
        q.__MstQueryHandler.updateData(
            {
                id: 'test',
                a: 'a',
                optionalProps1: 'optional',
                optionalProps2: ['optional'],
                optionalProps3: { a: 'a' },
            },
            { isLoading: false, error: null }
        )
    ).not.toThrow();
    expect(q.data?.id).toBe('test');
    expect(q.data?.a).toBe('a');
    expect(q.data).not.toHaveProperty('optionalProps1');
    expect(q.data).not.toHaveProperty('optionalProps2');
    expect(q.data).not.toHaveProperty('optionalProps3');
});
