export interface CommandArgs {
  readonly files: readonly string[];
  readonly show: boolean;
  readonly playwright: readonly string[];
}

const usage = 'Run: stardust test [files] [--show] [-- playwright flags]';

export function parseArgs(argv: readonly string[]): CommandArgs {
  const [command, ...rest] = argv;
  if (command !== 'test') {
    throw new Error(
      command === undefined
        ? `missing command. ${usage}`
        : `unknown command ${command}. ${usage}`,
    );
  }
  const end = rest.indexOf('--');
  const own = end === -1 ? rest : rest.slice(0, end);
  const files: string[] = [];
  let show = false;
  for (const arg of own) {
    if (arg === '--show') {
      show = true;
    } else if (arg.startsWith('-')) {
      throw new Error(
        `unknown flag ${arg.split('=')[0]}. Put Playwright flags after --, for example: stardust test -- --grep swap`,
      );
    } else {
      files.push(arg);
    }
  }
  return { files, show, playwright: end === -1 ? [] : rest.slice(end + 1) };
}
