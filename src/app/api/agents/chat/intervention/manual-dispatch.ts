/** Sending a human intervention authorizes this message, not its delivery.
 * The intervention already dispatches directly. The approval batch must skip
 * this owner (including on an explicit retry of a historical failed row). */
export const manualDispatchMetadata = {
  dispatch_owner: 'chat_intervention',
  status: 'accepted',
  command_status: 'pending',
} as const;