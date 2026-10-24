/** Own the connections, tasks, and revision state shared by one client process. */
import type { Config } from "./config";
import { Discovery } from "./ssh/discovery";
import { FileRevisions } from "./files/revisions";
import { SshTransport } from "./ssh/transport";
import { TaskManager } from "./tasks/manager";

export class Runtime {
  readonly ssh: SshTransport;
  readonly tasks: TaskManager;
  readonly discovery: Discovery;
  readonly files = new FileRevisions();
  private closing?: Promise<void>;

  constructor(readonly config: Config) {
    this.ssh = new SshTransport(config);
    this.tasks = new TaskManager(this.ssh);
    this.discovery = new Discovery(config);
  }

  /** Stop admission and let each worker clean up before retiring the task manager. */
  close(): Promise<void> {
    this.closing ??= this.ssh.close().finally(() => this.tasks.close());
    return this.closing;
  }
}
