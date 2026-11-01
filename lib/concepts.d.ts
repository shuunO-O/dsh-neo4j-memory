export declare const isKnownConceptSpelling: (name: string) => boolean;
export declare function conceptNameKey(name: string): string;
export interface ConceptMember {
    id: string;
    name: string;
    aliases: string[];
    first_context: string;
    events: string[];
}
export interface ConceptCandidate extends ConceptMember {
    group_id?: string;
    members?: ConceptMember[];
}
/** Recall may hit several spellings; compare their whole group only once. */
export declare function conceptGroups(candidates: ConceptCandidate[]): ConceptCandidate[];
