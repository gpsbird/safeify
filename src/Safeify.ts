import * as os from 'os';
import * as childProcess from 'child_process';
import { ChildProcess } from 'child_process';
import { ISafeifyOptions } from './ISafeifyOptions';
import { CGroups } from './CGroups';
import { IWorker } from './IWorker';
import { WorkerStatus } from './WorkerStatus';
import { MessageType } from './MessageType';
import { IMessage } from './IMessage';
import { Script } from './Script';

const { isFunction } = require('ntils');
const log = require('debug')('safeify');

const cpuTotal = os.cpus().length;
const timeout = 50;
const asyncTimeout = 500;
const cpuQuota = 0.5;
const memoryQuota = 500;
const quantity = cpuTotal > 1 ? cpuTotal : 2;
const runnerFile = require.resolve('./runner');
const sandbox = Object.create(null);

export class Safeify {

  private options: ISafeifyOptions = {};
  private workers: Array<IWorker> = [];
  private pendingScripts: Array<Script> = [];
  private runningScripts: Array<Script> = [];
  private cgroups: CGroups = null;
  private inited: boolean = false;

  constructor(opts: ISafeifyOptions = {}) {
    Object.assign(this.options, {
      timeout, quantity, sandbox, cpuQuota, memoryQuota
    }, opts);
  }

  public async init() {
    if (this.inited) return;
    this.inited = true;
    const { unrestricted } = this.options;
    if (!unrestricted) await this.createControlGroup();
    await this.createWorkers();
  }

  public distory = () => {
    this.workers.forEach(item => {
      item.process.removeAllListeners('message');
      item.process.removeAllListeners('disconnect');
      item.process.kill();
    });
    this.workers = [];
  }

  get workerTotal() {
    return this.workers.length;
  }

  get pendingTotal() {
    return this.pendingScripts.length;
  }

  get runningTotal() {
    return this.runningScripts.length;
  }

  private async onWokerCall(message: IMessage) {
    const { call, pid, scriptId } = message;
    if (!call) return;
    const script = this.runningScripts.find(item => item.id == scriptId);
    if (!script) return;
    try {
      call.result = await script.sandbox[call.name](...call.args);
    } catch (err) {
      call.error = err.message;
    }
    const worker = this.workers.find(item => item.process.pid == pid);
    if (!worker) return;
    const type = MessageType.ret;
    worker.process.send({ type, call })
  }

  private onWorkerMessage = (message: IMessage) => {
    switch (message.type) {
      case MessageType.done:
        return this.onWorkerDone(message);
      case MessageType.call:
        return this.onWokerCall(message);
    }
  }

  private onWorkerDone(message: IMessage) {
    const { pid, script, willExit } = message;
    if (!willExit) {
      //处理释放的 worker，并尝试处理新脚本
      const worker = this.workers.find(item => item.process.pid == pid);
      if (worker) {
        log('onWorkerDone free pid', worker.process.pid);
        worker.status = WorkerStatus.free;
        this.execute(worker);
      }
    }
    //处理执行完的脚本
    const runningIndex = this.runningScripts
      .findIndex(item => item.id === script.id);
    if (runningIndex > -1) {
      const runningScript = this.runningScripts.splice(runningIndex, 1)[0];
      if (runningScript) {
        if (script.error) {
          runningScript.reject(new Error(script.error), pid);
          log('onWorkerDone error', script.id, script.error);
        } else {
          runningScript.resolve(script.result, pid);
          log('onWorkerDone result', script.id, script.result);
        }
      }
    }
  }

  private onWorkerDisconnect = async () => {
    log('onWorkerDisconnect', 'pendingScripts', this.pendingScripts.length);
    this.workers = this.workers.filter(item => item.process.connected);
    const num = this.options.quantity - this.workers.length;
    const newWorkers = await this.createWorkers(num);
    log('onWorkerDisconnect', 'newWorkers', newWorkers.length);
    newWorkers.forEach(item => this.execute(item));
  }

  private createControlGroup() {
    this.cgroups = new CGroups('safeify');
    const { cpuQuota, memoryQuota } = this.options;
    return this.cgroups.set({
      cpu: { cfs_quota_us: 100000 * cpuQuota },
      memory: { limit_in_bytes: 1048576 * memoryQuota }
    });
  }

  private async createWorker() {
    const { unrestricted } = this.options;
    const process = childProcess.fork(runnerFile);
    if (!unrestricted) await this.cgroups.addProcess(process.pid);
    process.on('message', this.onWorkerMessage);
    process.on('disconnect', this.onWorkerDisconnect);
    const status = WorkerStatus.free;
    return { process, status };
  }

  private async createWorkers(num?: number) {
    if (!num) num = this.options.quantity;
    const newWorkers = [];
    for (let i = 0; i < num; i++) {
      newWorkers.push((async () => {
        const worker = await this.createWorker();
        this.workers.push(worker);
        return worker;
      })());
    }
    return Promise.all(newWorkers);
  }

  private execute(freeWorker?: IWorker) {
    const worker = freeWorker ? freeWorker : this.workers
      .find(item => item.status == WorkerStatus.free);
    if (!worker || worker.status == WorkerStatus.busy) return;
    log('execute pid', worker.process.pid);
    const script = this.pendingScripts.shift();
    if (!script) return;
    worker.status = WorkerStatus.busy;
    this.runningScripts.push(script);
    log('execute code', script.code);
    worker.process.send({
      type: MessageType.run,
      script: script
    });
  }

  private parseCode(func: Function) {
    const result = /\{([\s\S]*)\}/.exec(func.toString());
    return result[1] || '';
  }

  public async run(code: string | Function, sandbox?: any) {
    await this.init();
    code = isFunction(code) ? this.parseCode(<Function>code) : <string>code;
    log('run', code);
    const { timeout } = this.options;
    const script = new Script({ code, timeout, asyncTimeout, sandbox });
    this.pendingScripts.push(script);
    this.execute();
    return script.defer;
  }

}