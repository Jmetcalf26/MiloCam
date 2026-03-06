
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

try {
  const util = require('yellowstone/dist/util');
  console.log('Successfully required yellowstone/dist/util');
  console.log('Exports:', Object.keys(util));
} catch (e) {
  console.error('Failed to require:', e);
}
