/** An error to send back to the app with an HTTP status. */
export class RelayError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
