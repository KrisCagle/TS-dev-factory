import type { TicketSource } from '../types.js';
import { github } from './github.js';
import { jira } from './jira.js';
import { linear } from './linear.js';
import type { Connector } from './types.js';

export const CONNECTORS: Connector[] = [github, linear, jira];
export const connectorFor = (source: TicketSource) => CONNECTORS.find((c) => c.source === source);
export { github };
