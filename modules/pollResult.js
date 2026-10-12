'use strict';

/** Outcomes from pollers that keep going after an individual read fails. */
class PollResult {
  constructor() {
    this.attempted = 0;
    this.errors = [];
  }

  success() { this.attempted++; }

  fail(error) {
    this.attempted++;
    this.errors.push(error instanceof Error ? error : new Error(String(error)));
  }

  get error() {
    return new AggregateError(this.errors, this.errors.map(e => e.message).join('; '));
  }
}

module.exports = { PollResult };
