import Lake
open Lake DSL

-- Toolchain: leanprover/lean4:v4.34.1, the newest stable release at least 7 days
-- old at pin time (released 2026-09-24; pinned 2026-10-08).

package «sched» where

lean_lib «Sched» where

@[default_target]
lean_exe «sched» where
  root := `Main
