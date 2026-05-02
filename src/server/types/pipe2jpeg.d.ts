declare module 'pipe2jpeg' {
    import { Transform } from 'stream';

    class Pipe2Jpeg extends Transform {
        constructor();
        on(event: 'jpeg', listener: (jpegBuffer: Buffer) => void): this;
        on(event: string | symbol, listener: (...args: any[]) => void): this;
    }

    export = Pipe2Jpeg;
}
