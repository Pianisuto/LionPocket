/** Set only by the isolated development entry point before opening its bank. */
export function syntheticBankOptIn() {
  return (
    (globalThis as typeof globalThis & { lionPocketSyntheticSync?: boolean })
      .lionPocketSyntheticSync === true
  );
}
