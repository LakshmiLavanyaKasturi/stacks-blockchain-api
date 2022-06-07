import { io } from 'socket.io-client';
import { ChainID } from '@stacks/common';
import { ApiServer, startApiServer } from '../api/init';
import { DbTxStatus } from '../datastore/common';
import { waiter, Waiter } from '../helpers';
import {
  Block,
  Microblock,
  MempoolTransaction,
  AddressTransactionWithTransfers,
  AddressStxBalanceResponse,
  Transaction,
} from '../../docs/generated';
import {
  TestBlockBuilder,
  testMempoolTx,
  TestMicroblockStreamBuilder,
} from '../test-utils/test-builders';
import { PgWriteStore } from '../datastore/pg-write-store';
import { cycleMigrations, runMigrations } from '../datastore/migrations';

describe('socket-io', () => {
  let apiServer: ApiServer;
  let db: PgWriteStore;

  beforeEach(async () => {
    process.env.PG_DATABASE = 'postgres';
    await cycleMigrations();
    db = await PgWriteStore.connect({ usageName: 'tests', skipMigrations: true });
    apiServer = await startApiServer({
      datastore: db,
      chainId: ChainID.Testnet,
      httpLogLevel: 'silly',
    });
  });

  test('socket-io > block updates', async () => {
    const address = apiServer.address;
    const socket = io(`http://${address}`, {
      reconnection: false,
      query: { subscriptions: 'block' },
    });
    const updateWaiter: Waiter<Block> = waiter();
    socket.on('block', block => {
      updateWaiter.finish(block);
    });

    const block = new TestBlockBuilder({ block_hash: '0x1234', burn_block_hash: '0x5454' })
      .addTx({ tx_id: '0x4321' })
      .build();
    await db.update(block);

    const result = await updateWaiter;
    try {
      expect(result.hash).toEqual('0x1234');
      expect(result.burn_block_hash).toEqual('0x5454');
      expect(result.txs[0]).toEqual('0x4321');
    } finally {
      socket.emit('unsubscribe', 'block');
      socket.close();
    }
  });

  test('socket-io > microblock updates', async () => {
    const socket = io(`http://${apiServer.address}`, {
      reconnection: false,
      query: { subscriptions: 'microblock' },
    });
    const updateWaiter: Waiter<Microblock> = waiter();
    socket.on('microblock', microblock => {
      updateWaiter.finish(microblock);
    });

    const block = new TestBlockBuilder({ block_hash: '0x1212', index_block_hash: '0x4343' })
      .addTx()
      .build();
    await db.update(block);
    const microblocks = new TestMicroblockStreamBuilder()
      .addMicroblock({
        microblock_hash: '0xff01',
        parent_index_block_hash: '0x4343',
      })
      .addTx({ tx_id: '0xf6f6' })
      .build();
    await db.updateMicroblocks(microblocks);

    const result = await updateWaiter;
    try {
      expect(result.microblock_hash).toEqual('0xff01');
      expect(result.parent_block_hash).toEqual('0x1212');
      expect(result.txs[0]).toEqual('0xf6f6');
    } finally {
      socket.emit('unsubscribe', 'microblock');
      socket.close();
    }
  });

  test('socket-io > tx updates', async () => {
    const address = apiServer.address;
    const socket = io(`http://${address}`, {
      reconnection: false,
      query: { subscriptions: 'mempool,transaction:0x01' },
    });
    const mempoolWaiter: Waiter<MempoolTransaction> = waiter();
    const txWaiters: Waiter<MempoolTransaction | Transaction>[] = [waiter(), waiter()];
    let txWaiterIndex = 0;
    socket.on('mempool', tx => {
      mempoolWaiter.finish(tx);
    });
    socket.on('transaction', tx => {
      txWaiters[txWaiterIndex++].finish(tx);
    });

    const block = new TestBlockBuilder().addTx().build();
    await db.update(block);

    const mempoolTx = testMempoolTx({ tx_id: '0x01', status: DbTxStatus.Pending });
    await db.updateMempoolTxs({ mempoolTxs: [mempoolTx] });

    const microblock = new TestMicroblockStreamBuilder()
      .addMicroblock()
      .addTx({ tx_id: '0x01' })
      .build();
    await db.updateMicroblocks(microblock);

    const mempoolResult = await mempoolWaiter;
    const txResult = await txWaiters[0];
    const txMicroblockResult = await txWaiters[1];
    try {
      expect(mempoolResult.tx_status).toEqual('pending');
      expect(mempoolResult.tx_id).toEqual('0x01');
      expect(txResult.tx_status).toEqual('pending');
      expect(txResult.tx_id).toEqual('0x01');
      expect(txMicroblockResult.tx_id).toEqual('0x01');
      expect(txMicroblockResult.tx_status).toEqual('success');
    } finally {
      socket.emit('unsubscribe', 'mempool');
      socket.emit('unsubscribe', 'transaction:0x01');
      socket.close();
    }
  });

  test('socket-io > mempool txs', async () => {
    process.env.STACKS_MEMPOOL_TX_GARBAGE_COLLECTION_THRESHOLD = '0';

    const address = apiServer.address;
    const socket = io(`http://${address}`, {
      reconnection: false,
      query: { subscriptions: 'mempool' },
    });
    const txWaiters: Waiter<MempoolTransaction | Transaction>[] = [waiter(), waiter()];
    let txWaiterIndex = 0;
    socket.on('mempool', tx => {
      txWaiters[txWaiterIndex++].finish(tx);
    });

    const block1 = new TestBlockBuilder({ block_height: 1, index_block_hash: '0x01' })
      .addTx()
      .build();
    await db.update(block1);

    const mempoolTx = testMempoolTx({ tx_id: '0x01', status: DbTxStatus.Pending });
    await db.updateMempoolTxs({ mempoolTxs: [mempoolTx] });
    const pendingResult = await txWaiters[0];

    const block2 = new TestBlockBuilder({
      block_height: 2,
      index_block_hash: '0x02',
      parent_index_block_hash: '0x01',
    })
      .addTx()
      .build();
    await db.update(block2);

    const droppedResult = await txWaiters[1];
    try {
      expect(pendingResult.tx_status).toEqual('pending');
      expect(pendingResult.tx_id).toEqual('0x01');
      expect(droppedResult.tx_status).toEqual('dropped_stale_garbage_collect');
      expect(droppedResult.tx_id).toEqual('0x01');
    } finally {
      socket.emit('unsubscribe', 'mempool');
      socket.close();
    }
  });

  test('socket-io > address tx updates', async () => {
    const addr1 = 'ST28D4Q6RCQSJ6F7TEYWQDS4N1RXYEP9YBWMYSB97';
    const socket = io(`http://${apiServer.address}`, {
      reconnection: false,
      query: { subscriptions: `address-transaction:${addr1}` },
    });
    let updateIndex = 0;
    const addrTxUpdates: Waiter<AddressTransactionWithTransfers>[] = [waiter(), waiter()];
    socket.on(`address-transaction:${addr1}`, (_, tx) => {
      addrTxUpdates[updateIndex++]?.finish(tx);
    });

    const block = new TestBlockBuilder({
      block_height: 1,
      block_hash: '0x01',
      index_block_hash: '0x01',
    })
      .addTx({ tx_id: '0x8912', sender_address: addr1, token_transfer_amount: 100n, fee_rate: 50n })
      .addTxStxEvent({ sender: addr1, amount: 100n })
      .build();
    await db.update(block);
    const blockResult = await addrTxUpdates[0];

    const microblock = new TestMicroblockStreamBuilder()
      .addMicroblock({
        microblock_hash: '0x11',
        parent_index_block_hash: '0x01',
      })
      .addTx({
        tx_id: '0x8913',
        sender_address: addr1,
        token_transfer_amount: 150n,
        fee_rate: 50n,
      })
      .addTxStxEvent({ sender: addr1, amount: 150n })
      .build();
    await db.updateMicroblocks(microblock);
    const microblockResult = await addrTxUpdates[1];

    try {
      expect(blockResult.tx.tx_id).toEqual('0x8912');
      expect(blockResult.stx_sent).toEqual('150'); // Incl. fees
      expect(blockResult.stx_transfers[0].amount).toEqual('100');
      expect(microblockResult.tx.tx_id).toEqual('0x8913');
      expect(microblockResult.stx_sent).toEqual('200'); // Incl. fees
      expect(microblockResult.stx_transfers[0].amount).toEqual('150');
    } finally {
      socket.emit('unsubscribe', `address-transaction:${addr1}`);
      socket.close();
    }
  });

  test('socket-io > address balance updates', async () => {
    const addr2 = 'STB44HYPYAT2BB2QE513NSP81HTMYWBJP02HPGK6';
    const address = apiServer.address;
    const socket = io(`http://${address}`, {
      reconnection: false,
      query: { subscriptions: `address-stx-balance:${addr2}` },
    });
    const updateWaiter: Waiter<AddressStxBalanceResponse> = waiter();

    socket.on(`address-stx-balance:${addr2}`, (_, tx) => {
      updateWaiter.finish(tx);
    });
    const block = new TestBlockBuilder()
      .addTx({
        token_transfer_recipient_address: addr2,
        token_transfer_amount: 100n,
      })
      .addTxStxEvent({ recipient: addr2, amount: 100n })
      .build();
    await db.update(block);

    const result = await updateWaiter;
    try {
      expect(result.balance).toEqual('100');
    } finally {
      socket.emit('unsubscribe', `address-stx-balance:${addr2}`);
      socket.close();
    }
  });

  test('socket-io > invalid topic connection', async () => {
    const faultyAddr = 'faulty address';
    const address = apiServer.address;
    const socket = io(`http://${address}`, {
      reconnection: false,
      query: { subscriptions: `address-stx-balance:${faultyAddr}` },
    });
    const updateWaiter: Waiter<Error> = waiter();

    socket.on(`connect_error`, err => {
      updateWaiter.finish(err);
    });

    const result = await updateWaiter;
    try {
      throw result;
    } catch (err: any) {
      expect(err.message).toEqual(`Invalid topic: address-stx-balance:${faultyAddr}`);
    } finally {
      socket.close();
    }
  });

  test('socket-io > multiple invalid topic connection', async () => {
    const faultyAddrStx = 'address-stx-balance:faulty address';
    const faultyTx = 'transaction:0x1';
    const address = apiServer.address;
    const socket = io(`http://${address}`, {
      reconnection: false,
      query: { subscriptions: `${faultyAddrStx},${faultyTx}` },
    });
    const updateWaiter: Waiter<Error> = waiter();

    socket.on(`connect_error`, err => {
      updateWaiter.finish(err);
    });

    const result = await updateWaiter;
    try {
      throw result;
    } catch (err: any) {
      expect(err.message).toEqual(`Invalid topic: ${faultyAddrStx}, ${faultyTx}`);
    } finally {
      socket.close();
    }
  });

  test('socket-io > valid socket subscription', async () => {
    const address = apiServer.address;
    const socket = io(`http://${address}`, {
      reconnection: false,
      query: { subscriptions: '' },
    });
    const updateWaiter: Waiter<Block> = waiter();

    socket.on('block', block => {
      updateWaiter.finish(block);
    });

    socket.emit('subscribe', 'block');

    const block = new TestBlockBuilder({ block_hash: '0x1234', burn_block_hash: '0x5454' })
      .addTx({ tx_id: '0x4321' })
      .build();
    await db.update(block);

    const result = await updateWaiter;
    try {
      expect(result.hash).toEqual('0x1234');
      expect(result.burn_block_hash).toEqual('0x5454');
      expect(result.txs[0]).toEqual('0x4321');
    } finally {
      socket.emit('unsubscribe', 'block');
      socket.close();
    }
  });

  afterEach(async () => {
    await apiServer.terminate();
    await db?.close();
    await runMigrations(undefined, 'down');
  });
});
