import contentScript from "../../../extension/entrypoints/capture.content";

const invalidated = [];
contentScript.main({ onInvalidated: (callback) => invalidated.push(callback) });
Object.assign(window, { invalidatePicker: () => invalidated.forEach((callback) => callback()) });
