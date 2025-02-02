import { flow, types } from 'mobx-state-tree';
import { createQuery, MstQueryRef } from '../../src';
import { ListModel } from './ListModel';

export const ListQuery = createQuery('ListQuery', {
    data: MstQueryRef(ListModel),
    request: types.model({ id: types.string }),
    pagination: types.optional(types.model({ offset: types.optional(types.number, 0) }), {}),
}).actions((self) => ({
    run: flow(function* () {
        const next = yield* self.query(self.env.api.getItems);
        next();
    }),
    addItem(item: any) {
        self.data?.addItem(item);
    },
    removeItem(item: any) {
        self.data?.removeItem(item);
    },
    fetchMore: flow(function* () {
        self.pagination.offset += 4;

        const next = yield* self.queryMore(self.env.api.getItems);
        const { data } = next<typeof ListQuery>();
        if (data?.items) {
            self.data?.addItems(data.items);
        }
    }),
}));
