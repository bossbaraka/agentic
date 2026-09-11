import './env.js';
import { openDb } from '../../src/db/client.js';
import { seedAll } from '../../src/db/seed.js';

openDb();
seedAll();

export { openDb };
