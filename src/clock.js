/**
 * Wall clock that can be frozen and advanced. Tests and seeds freeze it;
 * the server releases it to real time after seeding.
 */
export class Clock {
  #frozen = null;

  now = () => (this.#frozen ? new Date(this.#frozen.getTime()) : new Date());

  freeze(at) {
    this.#frozen = new Date(at);
    return this;
  }

  advance(ms) {
    if (!this.#frozen) throw new Error('advance() needs a frozen clock');
    this.#frozen = new Date(this.#frozen.getTime() + ms);
    return this;
  }

  release() {
    this.#frozen = null;
    return this;
  }
}
