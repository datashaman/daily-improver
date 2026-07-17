import type { OpenPullRequestLimitDecision, OpenPullRequestState } from "../domain/model.js";

export function decideOpenPullRequestLimit(
  state: OpenPullRequestState,
  maxOpenPullRequests: number,
  decidedAt: string,
): OpenPullRequestLimitDecision {
  return {
    schemaVersion: "open-pull-request-limit-decision/v1",
    repositoryId: state.repositoryId,
    observedAt: state.observedAt,
    openPullRequests: state.openPullRequests,
    maxOpenPullRequests,
    outcome: state.openPullRequests < maxOpenPullRequests ? "allowed" : "blocked",
    decidedAt,
  };
}
