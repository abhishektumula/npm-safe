// Minimal ambient types for @npmcli/arborist.
// Arborist ships no bundled types and @types/npmcli__arborist tracks an
// old major, so we declare exactly the surface nps uses. If the library
// ever changes this surface, the mismatch fails here — loudly, in one place.
declare module "@npmcli/arborist" {
  export interface ArboristOptions {
    path?: string;
    save?: boolean;
    saveType?: "prod" | "dev" | "optional" | "peer" | "peerOptional";
    savePrefix?: string;
    saveBundle?: boolean;
    [key: string]: unknown;
  }

  export interface IdealTreeOptions {
    add?: string[];
    rm?: string[];
    saveType?: ArboristOptions["saveType"];
    saveBundle?: boolean;
    [key: string]: unknown;
  }

  export interface ReifyOptions {
    save?: boolean;
    [key: string]: unknown;
  }

  export interface IdealTree {
    inventory: Map<string, unknown>;
  }

  export default class Arborist {
    constructor(opts?: ArboristOptions);
    idealTree: IdealTree | undefined;
    buildIdealTree(opts?: IdealTreeOptions): Promise<IdealTree>;
    reify(opts?: ReifyOptions): Promise<void>;
  }
}
