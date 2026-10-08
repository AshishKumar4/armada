/** armada's SDK: typed tasks that run on a fleet of Cloudflare Containers. */
export { defineConfig, push } from './push';

export type { ArmadaConfig } from './push';

export { Job, MapError, recipe, RecipeBuilder, SchemaError, task } from './task';

export type { Answer, Context, Json, MapOptions, Meta, Output, Plain, Recipe, RecipeOptions, RemoteError, Result, Task, TaskConfig, Value } from './task';

export { sh, Shell, ShellError } from './sh';

export type { OutFile, Word } from './sh';

export { connect } from './sdk';

export type { Armada, Summary } from './sdk';

export type { Retries, Size } from './protocol';

export type { StandardSchemaV1 } from './standard-schema';
