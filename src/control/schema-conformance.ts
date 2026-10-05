import { Type, type Static, type TSchema, type TUnsafe } from "typebox";

import type { DeepReadonly } from "./agent-control-channel.ts";

/**
 * Compile-checked bindings between a wire schema and a type owned elsewhere.
 * TypeBox infers types from schemas but cannot build schemas from TypeScript
 * types, so each binding checks conformance instead. A failed check makes the
 * argument unassignable to a type that names the rule, the domain type, and the
 * schema's inferred type. The bound schema's static type is the domain type.
 */
export type ConformanceMismatch<Rule extends string, Domain, Schema> = Readonly<{
	conformanceMismatch: Rule;
	domain: Domain;
	schema: Schema;
}>;

type Assignable<From, To> = [DeepReadonly<From>] extends [DeepReadonly<To>] ? true : false;
type Conforms<Holds extends boolean, Mismatch> = Holds extends true ? unknown : Mismatch;

/** Values our domain code produces: the schema and the domain type must accept each other. */
export function bindEquivalent<Domain>() {
	return <S extends TSchema>(
		schema: S & Conforms<
			Assignable<Domain, Static<S>> extends true ? Assignable<Static<S>, Domain> : false,
			ConformanceMismatch<"equivalent", Domain, Static<S>>
		>,
	): TUnsafe<Domain> => Type.Unsafe<Domain>(schema);
}

/**
 * A tool's own parameter schema: every value it accepts must be a valid domain
 * input. The schema may refine the domain type, for example to require a filter.
 */
export function bindToolInput<DomainInput>() {
	return <S extends TSchema>(
		schema: S & Conforms<
			Assignable<Static<S>, DomainInput>,
			ConformanceMismatch<"tool_input", DomainInput, Static<S>>
		>,
	): TUnsafe<DomainInput> => Type.Unsafe<DomainInput>(schema);
}

/**
 * A Pi-owned shape: every value Pi's type allows must pass. The schema keeps
 * open objects, so fields this package never names still pass through.
 */
export function bindPiOwned<PiType>() {
	return <S extends TSchema>(
		schema: S & Conforms<
			Assignable<PiType, Static<S>>,
			ConformanceMismatch<"pi_owned", PiType, Static<S>>
		>,
	): TUnsafe<PiType> => Type.Unsafe<PiType>(schema);
}
