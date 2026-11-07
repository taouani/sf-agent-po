// Child process for the multi-process test: many small write transactions against one DB file.
import { configure, open, type DriverName } from './driver.ts';

const [driver, file, id, count, startAt] = process.argv.slice(2) as [DriverName, string, string, string, string];
const db = open(driver, file);
configure(db);
const insert = db.prepare('INSERT INTO feedback (writer, seq, body) VALUES (?, ?, ?)');
const read = db.prepare('SELECT count(*) n FROM feedback WHERE writer = ?');
// Wait for the shared start time so all writers contend at once.
const wait = Number(startAt) - Date.now();
if (wait > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
let errors = 0;
for (let i = 0; i < Number(count); i++) {
  try {
    db.tx(() => {
      insert.run(id, i, `verdict ${i} from writer ${id}`);
      read.get(id); // a read inside the write transaction, as a real feedback write would do
    });
  } catch (e) {
    errors++;
    if (errors === 1) console.error(`writer ${id}: ${(e as Error).message}`);
  }
}
db.close();
process.stdout.write(JSON.stringify({ id, errors }));
