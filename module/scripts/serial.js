/**
 * Returns a function that runs async tasks one at a time, in order.
 *
 * World settings are saved whole, so updating one entry is read, change,
 * write. The relay handles requests in parallel, and two of these running at
 * once would each write their own copy and lose the other's change. Every
 * read-modify-write of the same setting goes through the same queue.
 */
export function serial() {
  let tail = Promise.resolve();
  return task => {
    const run = tail.then(task, task);
    tail = run.catch(() => {});
    return run;
  };
}
