// Child process for the multi-process test: many small write transactions against one DB file.
import { configure, open, type DriverName } from './driver.ts';

const [driver, file, id, count] = process.argv.slice(2) as [DriverName, string, string, string];
const db = open(driver, file);
configure(db);
const insert = db.prepare('INSERT INTO feedback (writer, seq, body) VALUES (?, ?, ?)');
let errors = 0;
for (let i = 0; i < Number(count); i++) {
  try {
    db.tx(() => insert.run(id, i, `verdict ${i} from writer ${id}`));
  } catch (e) {
    errors++;
    if (errors === 1) console.error(`writer ${id}: ${(e as Error).message}`);
  }
}
db.close();
process.stdout.write(JSON.stringify({ id, errors }));
