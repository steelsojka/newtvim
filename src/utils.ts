import * as vscode from 'vscode';
import { Observable } from 'rxjs';

export type InferEventArgs<T> = T extends vscode.Event<infer A> ? A : any;

export class VsCodeEvent<T extends vscode.Event<any>> {
  constructor(public type: T, public payload: InferEventArgs<T>) {}
}

export function fromVsCodeCommand<T>(type: string): Observable<T> {
  return new Observable<T>(subscriber => {
    const sub = vscode.commands.registerCommand(type, args =>
      subscriber.next(args)
    );

    return () => sub.dispose();
  });
}

export function fromVsCodeEvent<T extends vscode.Event<any>>(
  event: T
): Observable<VsCodeEvent<T>> {
  return new Observable<VsCodeEvent<T>>(subscriber => {
    const sub = event(args => subscriber.next(new VsCodeEvent(event, args)));

    return () => sub.dispose();
  });
}
