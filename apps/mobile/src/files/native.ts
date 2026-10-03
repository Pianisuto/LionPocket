import { NativeModules } from 'react-native';
export interface LocalFile {
  name: string;
  location: 'transfers' | 'backups';
  path: string;
}
export interface PickedFile extends LocalFile {
  displayName: string;
}
export interface RecoveryFile extends LocalFile {
  createdAt: number;
  size: number;
}
export const localFiles = NativeModules.LionPocketFiles as {
  prepareFile(folder: LocalFile['location'], extension: string): Promise<LocalFile>;
  pickFile(): Promise<PickedFile | null>;
  writeText(folder: string, name: string, content: string): Promise<void>;
  readText(name: string): Promise<string>;
  readBase64(name: string): Promise<string>;
  saveFile(
    folder: string,
    name: string,
    mime: string,
    displayName: string,
  ): Promise<boolean | null>;
  listBackups(): Promise<RecoveryFile[]>;
  fingerprintBackup(name: string, seal: boolean): Promise<LocalFile & {sha256:string}>;
  copyBackup(name: string): Promise<PickedFile>;
  removeTransfer(name: string): Promise<void>;
};
