import { ensureGenerated } from './scoring.js';

const made = ensureGenerated();
console.log(made.length ? `Generated: ${made.join(', ')}` : 'All fixtures are up to date.');
