import { Subject } from 'rxjs';
import {
  distinctUntilChanged,
  map,
  startWith,
  shareReplay,
  tap
} from 'rxjs/operators';

export enum VimMode {
  NORMAL = 'normal',
  INSERT = 'insert',
  VISUAL = 'visual'
}

export enum RedrawEvent {
  MODE_CHANGE = 'mode_change',
  CURSOR_GOTO = 'cursor_goto'
}

export type RedrawEventHandler<T extends any[] = any[]> = (args: T) => void;

export class Screen {
  private mode: VimMode = VimMode.NORMAL;
  private cursorX: number = 0;
  private cursorY: number = 0;

  private _updated$ = new Subject<void>();
  public readonly updated$ = this._updated$.asObservable();

  public readonly mode$ = this.updated$.pipe(
    map(() => this.mode),
    startWith(this.mode),
    distinctUntilChanged(),
    shareReplay(1)
  );

  public readonly cursorPosition$ = this.updated$.pipe(
    map(() => ({ x: this.cursorX, y: this.cursorY })),
    startWith({ x: this.cursorX, y: this.cursorY }),
    distinctUntilChanged((a, b) => a.x === b.x && a.y === b.y),
    shareReplay(1)
  );

  private handlers = new Map<RedrawEvent, RedrawEventHandler>([
    [RedrawEvent.MODE_CHANGE, ([mode]) => (this.mode = mode)],
    [
      RedrawEvent.CURSOR_GOTO,
      ([y, x]) => {
        this.cursorX = x;
        this.cursorY = y;
      }
    ]
  ]);

  public async redraw(events: [string, any[]][]): Promise<void> {
    for (const [eventName, eventArgs] of events) {
      const handler = this.handlers.get(eventName as RedrawEvent);

      if (handler) {
        handler(eventArgs);
      }
    }

    this._updated$.next();
  }
}
