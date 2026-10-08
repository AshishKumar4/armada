import { eslintCompatPlugin } from "@oxlint/plugins";

import { noAmbientBunInTestsRule } from "./rules/no-ambient-bun-in-tests.ts";
import { noAmbientGitInTestsRule } from "./rules/no-ambient-git-in-tests.ts";
import { noChainedTypeAssertionsRule } from "./rules/no-chained-type-assertions.ts";
import { noCliCredentialFlagRule } from "./rules/no-cli-credential-flag.ts";
import { noConditionalEmptyObjectSpreadRule } from "./rules/no-conditional-empty-object-spread.ts";
import { noDdlInCatchRule } from "./rules/no-ddl-in-catch.ts";
import { noEmptyCatchRule } from "./rules/no-empty-catch.ts";
import { noKnownValueWideningRule } from "./rules/no-known-value-widening.ts";
import { noModuleMockingRule } from "./rules/no-module-mocking.ts";
import { noNearDuplicateFunctionsRule } from "./rules/no-near-duplicate-functions.ts";
import { noObjectParametersRule } from "./rules/no-object-parameters.ts";
import { noReduceAccumulatorCopyRule } from "./rules/no-reduce-accumulator-copy.ts";
import { noReflectApplyRule } from "./rules/no-reflect-apply.ts";
import { noReflectGetRule } from "./rules/no-reflect-get.ts";
import { noRuntimeTypeofRule } from "./rules/no-runtime-typeof.ts";
import { noSentinelCatchRule } from "./rules/no-sentinel-catch.ts";
import { noForbiddenTermInSymbolNamesRule } from "./rules/no-shape-in-symbol-names.ts";
import { noUnaccountedCatchRule } from "./rules/no-unaccounted-catch.ts";
import { noUnknownParametersRule } from "./rules/no-unknown-parameters.ts";
import { noUnknownReturnsRule } from "./rules/no-unknown-returns.ts";
import { noUnknownTypeAliasesRule } from "./rules/no-unknown-type-aliases.ts";
import { noUnsafeDictionaryTypeRule } from "./rules/no-unsafe-dictionary-type.ts";
import { noVacuousTypePredicateRule } from "./rules/no-vacuous-type-predicate.ts";
import { noWaitUntilInDurableObjectRule } from "./rules/no-wait-until-in-durable-object.ts";
import { noWidenThenAssertRule } from "./rules/no-widen-then-assert.ts";
import { requireCauseOnRethrowRule } from "./rules/require-cause-on-rethrow.ts";
import { requireReadableSpacingRule } from "./rules/require-readable-spacing.ts";
import { requireSafetyCommentForTypeAssertionRule } from "./rules/require-safety-comment-for-type-assertion.ts";

/**
 * Oxlint rules that reject low-evidence implementation patterns. Vendored from Kinu's tools/oxlint/anti-slop (which
 * pins upstream dmmulroy/anti-slop; see upstream.json), keeping the rules that apply to armada's code.
 */
const antiSlopPlugin = eslintCompatPlugin({
	meta: { name: "anti-slop" },
	rules: {
		"no-ambient-bun-in-tests": noAmbientBunInTestsRule,
		"no-ambient-git-in-tests": noAmbientGitInTestsRule,
		"no-chained-type-assertions": noChainedTypeAssertionsRule,
		"no-cli-credential-flag": noCliCredentialFlagRule,
		"no-conditional-empty-object-spread": noConditionalEmptyObjectSpreadRule,
		"no-ddl-in-catch": noDdlInCatchRule,
		"no-empty-catch": noEmptyCatchRule,
		"no-known-value-widening": noKnownValueWideningRule,
		"no-module-mocking": noModuleMockingRule,
		"no-near-duplicate-functions": noNearDuplicateFunctionsRule,
		"no-object-parameters": noObjectParametersRule,
		"no-reduce-accumulator-copy": noReduceAccumulatorCopyRule,
		"no-reflect-apply": noReflectApplyRule,
		"no-reflect-get": noReflectGetRule,
		"no-runtime-typeof": noRuntimeTypeofRule,
		"no-sentinel-catch": noSentinelCatchRule,
		"no-shape-in-symbol-names": noForbiddenTermInSymbolNamesRule,
		"no-unaccounted-catch": noUnaccountedCatchRule,
		"no-unknown-parameters": noUnknownParametersRule,
		"no-unknown-returns": noUnknownReturnsRule,
		"no-unknown-type-aliases": noUnknownTypeAliasesRule,
		"no-unsafe-dictionary-type": noUnsafeDictionaryTypeRule,
		"no-vacuous-type-predicate": noVacuousTypePredicateRule,
		"no-wait-until-in-durable-object": noWaitUntilInDurableObjectRule,
		"no-widen-then-assert": noWidenThenAssertRule,
		"require-cause-on-rethrow": requireCauseOnRethrowRule,
		"require-readable-spacing": requireReadableSpacingRule,
		"require-safety-comment-for-type-assertion": requireSafetyCommentForTypeAssertionRule,
	},
});

export default antiSlopPlugin;
