import { NativeModules } from 'react-native';
export const nativeUi = NativeModules.LionPocketUi as {
  pickDate(value: string, light: boolean): Promise<string | null>;
};
