declare module 'cross-spawn' {
  import { spawn, type SpawnOptions } from 'node:child_process';

  function crossSpawn(
    command: string,
    args?: readonly string[],
    options?: SpawnOptions,
  ): ReturnType<typeof spawn>;

  export default crossSpawn;
}
