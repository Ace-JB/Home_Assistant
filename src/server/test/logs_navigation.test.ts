import { describe, expect, test } from 'bun:test';
import { choosePipelineIdAfterLogRefresh } from '../../components/logsNavigation';

describe('LogsView navigation helpers', () => {
    test('uses pending returned pipeline before falling back to the first refreshed item', () => {
        const pipelines = [{ id: 'latest-pipeline' }, { id: 'returned-pipeline' }];

        expect(choosePipelineIdAfterLogRefresh(pipelines, 'returned-pipeline', null)).toBe('returned-pipeline');
    });

    test('keeps the selected pipeline when no pending return target exists', () => {
        const pipelines = [{ id: 'latest-pipeline' }, { id: 'selected-pipeline' }];

        expect(choosePipelineIdAfterLogRefresh(pipelines, null, 'selected-pipeline')).toBe('selected-pipeline');
    });
});
