declare module 'yauzl' {
    export type Entry = {
        fileName: string;
        uncompressedSize?: number;
    };

    export type ZipFile = {
        readEntry(): void;
        close(): void;
        on(event: 'entry', listener: (entry: Entry) => void): ZipFile;
        on(event: 'end', listener: () => void): ZipFile;
        on(event: 'error', listener: (error: Error) => void): ZipFile;
        openReadStream(entry: Entry, callback: (error: Error | null, stream: NodeJS.ReadableStream | null) => void): void;
    };

    export function open(
        path: string,
        options: { lazyEntries?: boolean },
        callback: (error: Error | null, zipFile: ZipFile | null) => void,
    ): void;
}
