/** Integer-only subset of RFC 8785. No normalization, lossy values or platform APIs. */
export function canonicalStringify(value: unknown): string {
  const ancestors = new Set<object>();
  const string = (text: string): string => {
    for (let index = 0; index < text.length; index++) {
      const unit = text.charCodeAt(index);
      if (unit >= 0xd800 && unit <= 0xdbff) {
        const next = text.charCodeAt(++index);
        if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error('Invalid Unicode scalar.');
      } else if (unit >= 0xdc00 && unit <= 0xdfff) throw new Error('Invalid Unicode scalar.');
    }
    return JSON.stringify(text);
  };
  const visit = (item: unknown): string => {
    if (item === null) return 'null';
    if (typeof item === 'string') return string(item);
    if (typeof item === 'boolean') return String(item);
    if (typeof item === 'number') {
      if (!Number.isSafeInteger(item) || Object.is(item, -0)) throw new Error('Expected safe integer.');
      return String(item);
    }
    if (typeof item !== 'object') throw new Error('Expected JSON value.');
    if (ancestors.has(item)) throw new Error('Cyclic JSON value.');
    ancestors.add(item);
    try {
      if (Array.isArray(item)) {
        if (Object.getOwnPropertyNames(item).length !== item.length + 1 || Object.getOwnPropertySymbols(item).length)
          throw new Error('Extra array properties.');
        const values: string[] = [];
        for (let index = 0; index < item.length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
          if (!descriptor) throw new Error('Sparse array.');
          if (!('value' in descriptor) || !descriptor.enumerable) throw new Error('Accessor or hidden array property.');
          values.push(visit(descriptor.value));
        }
        return `[${values.join(',')}]`;
      }
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null)
        throw new Error('Expected plain JSON object.');
      if (Object.getOwnPropertySymbols(item).length) throw new Error('Symbol JSON key.');
      if (Object.getOwnPropertyNames(item).length !== Object.keys(item).length)
        throw new Error('Hidden JSON property.');
      return `{${Object.keys(item).sort().map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!descriptor || !('value' in descriptor)) throw new Error('Accessor JSON property.');
        return `${string(key)}:${visit(descriptor.value)}`;
      }).join(',')}}`;
    } finally {
      ancestors.delete(item);
    }
  };
  return visit(value);
}
