/** armada's SDK: typed tasks that run on a fleet of Cloudflare Containers. */
export { cmd, fn, Job, MapError, recipe, SchemaError } from './task';
export type { CmdOptions, Context, FnOptions, Json, MapOptions, Meta, Plain, Recipe, RecipeOptions, RemoteError, Result, Task, TaskOptions, Value } from './task';
export { connect } from './sdk';
export type { Armada, Summary } from './sdk';
export type { Size } from './protocol';
export type { StandardSchemaV1 } from './standard-schema';
