export const Platform = { OS: "web" as const, select: (o:any)=>o.web };
export const NativeModules = {};
export const NativeEventEmitter = class { addListener(){return {remove(){}}} };
export default {};
