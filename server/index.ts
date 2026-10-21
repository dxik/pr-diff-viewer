import { createServer } from './http.js';

createServer().listen(4318, '127.0.0.1', () => {
  process.stdout.write('PR review: http://127.0.0.1:4318\n');
});
