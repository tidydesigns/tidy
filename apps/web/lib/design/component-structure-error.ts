/** Identifies the exact linked instance whose structure rejected an edit. */
export class ComponentStructureError extends Error {
  constructor(
    message: string,
    readonly instanceId: string,
    readonly componentId: string,
  ) {
    super(message);
    this.name = "ComponentStructureError";
  }
}
