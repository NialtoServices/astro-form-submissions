/**
 * A write-once store refused to replace the object already under a key. Thrown by
 * {@link FileStorage.putStream}, so an object can't be rewritten after a submission has checked its bytes.
 */
export class ObjectExistsError extends Error {
  // MARK: - Object Lifecycle

  constructor(readonly key: string) {
    super(`An object is already stored under "${key}".`)
    this.name = 'ObjectExistsError'
  }
}
