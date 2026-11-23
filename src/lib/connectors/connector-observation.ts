/** Private business arguments must not be duplicated in shared Robots tool logs or recovery
 * observations. This is a logging projection, not routing or evidence that an action ran. */
export function connectorObservation(name:unknown,args:unknown): {action:string;private_arguments:true}|undefined {
  if (name!=='tools' && name!=='use_composio_tools') return;
  const own = (key:string) => args && typeof args==='object' ? Object.getOwnPropertyDescriptor(args,key)?.value : undefined;
  const ref=own('name'), action=own('action');
  if (name==='tools' && !(typeof ref==='string' && ref.startsWith('connector:')) && own('connector_id')===undefined && own('catalog_query')===undefined) return;
  const operation=action==='execute' || action==='call' ? 'call' : action==='describe' || action==='search' || action==='list' ? action : 'connector';
  return {action:operation,private_arguments:true};
}