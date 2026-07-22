// Zeroshot has no runtime permission-mode switching (its agents run fully
// autonomously by design) and no HAPI-level model/effort surface, so its
// "mode" carries nothing beyond what MessageQueue2's generic batching needs.
export interface ZeroshotMode {
    placeholder?: never;
}
