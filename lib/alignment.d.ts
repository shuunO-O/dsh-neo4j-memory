import { ModelClient } from './api.js';
export interface Candidate {
    id: string;
    name: string;
    aliases: string[];
    first_context: string;
    events: string[];
}
export interface EntityRecord {
    id: string;
    name: string;
    label: string;
    embedding: number[];
    alignment?: Decision;
    first_context?: string;
}
export interface Score {
    score: number;
    probabilities: Record<'0' | '1' | '2', number>;
    confidence: number;
}
export interface Decision {
    mention: string;
    target_id: string;
    action: 'create' | 'reuse';
    status: string;
    reason: string;
    candidates: ({
        id: string;
    } | (Score & {
        id: string;
        name: string;
    }))[];
    rule_version: string;
    model: string;
    same_probability: number;
    different_probability: number;
    error_code?: string;
    error_type?: string;
}
export declare function validateAnswer(answer: any): Score;
export declare function alignConcepts(client: ModelClient, records: EntityRecord[], content: string, summary: string, recall: (name: string, vector: number[], limit: number, signal?: AbortSignal) => Promise<Candidate[]>): Promise<Decision[]>;
