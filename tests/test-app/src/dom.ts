export function byId<T extends HTMLElement>(id: string, type: new () => T): T {
  const element = document.getElementById(id);
  if (!(element instanceof type)) {
    throw new Error(`#${id} isn't a ${type.name}`);
  }
  return element;
}

export function run(action: () => Promise<void>): void {
  action().catch((error: unknown) =>
    say(error instanceof Error ? error.message : String(error)),
  );
}

export function onClick(id: string, action: () => Promise<void>): void {
  byId(id, HTMLButtonElement).addEventListener('click', () => run(action));
}

export function say(text: string): void {
  byId('status', HTMLParagraphElement).textContent = text;
}
