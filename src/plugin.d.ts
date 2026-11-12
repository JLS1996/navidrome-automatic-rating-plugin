declare module "main" {
  export function nd_on_init(): I32;
  export function nd_scheduler_callback(): I32;
  export function automatic_ratings_calculate(): I32;
}
declare module "extism:host" {
  interface user {
    subsonicapi_call(ptr: I64): I64;
    users_getusers(ptr: I64): I64;
    library_getalllibraries(ptr: I64): I64;
    scheduler_schedulerecurring(ptr: I64): I64;
    scheduler_cancelschedule(ptr: I64): I64;
    kvstore_get(ptr: I64): I64;
    kvstore_set(ptr: I64): I64;
    kvstore_list(ptr: I64): I64;
  }
}
