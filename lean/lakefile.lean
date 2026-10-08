import Lake
open Lake DSL
package armada where
  leanOptions := #[⟨`autoImplicit, false⟩]
@[default_target]
lean_lib Armada
