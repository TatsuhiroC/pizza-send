// The hash dependency calls this during module initialization. ES2020 syntax
// alone cannot supply newer runtime APIs; load this before importing hashes.
if (typeof Object.hasOwn !== 'function') {
  Object.defineProperty(Object, 'hasOwn', {
    configurable: true, writable: true,
    value: (value: unknown, key: PropertyKey) => Object.prototype.hasOwnProperty.call(value, key)
  });
}
