import * as express from 'express';
import { asyncHandler } from '../../async-handler';
import { PgStore } from '../../../datastore/pg-store';
import { isUnanchoredRequest } from '../../query-helpers';
import { ChainID } from '@stacks/transactions';

const SUPPORTED_BLOCKCHAINS = ['stacks'];

export function createBnsAddressesRouter(db: PgStore, chainId: ChainID): express.Router {
  const router = express.Router();
  router.get(
    '/:blockchain/:address',
    asyncHandler(async (req, res, next) => {
      // Retrieves a list of names owned by the address provided.
      const { blockchain, address } = req.params;
      if (!SUPPORTED_BLOCKCHAINS.includes(blockchain)) {
        res.status(404).json({ error: 'Unsupported blockchain' });
        return;
      }
      const includeUnanchored = isUnanchoredRequest(req, res, next);
      const namesByAddress = await db.getNamesByAddressList({
        address: address,
        includeUnanchored,
        chainId,
      });
      if (namesByAddress.found) {
        res.json({ names: namesByAddress.result });
      } else {
        res.json({ names: [] });
      }
    })
  );

  return router;
}
