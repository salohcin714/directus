/**
 * Process a given payload for a collection to ensure the special fields (hash, uuid, date etc) are
 * handled correctly.
 */

import { FieldMeta } from '../types/field';
import argon2 from 'argon2';
import { v4 as uuidv4 } from 'uuid';
import database from '../database';
import { clone, isObject } from 'lodash';
import { Relation, Item, AbstractServiceOptions, Accountability, PrimaryKey } from '../types';
import ItemsService from './items';
import { URL } from 'url';
import Knex from 'knex';
import env from '../env';

type Operation = 'create' | 'read' | 'update';

type Transformers = {
	[type: string]: (operation: Operation, value: any, payload: Partial<Item>) => Promise<any>;
};

export default class PayloadService {
	accountability: Accountability | null;
	knex: Knex;
	collection: string;

	constructor(collection: string, options?: AbstractServiceOptions) {
		this.accountability = options?.accountability || null;
		this.knex = options?.knex || database;
		this.collection = collection;

		return this;
	}

	/**
	 * @todo allow this to be extended
	 *
	 * @todo allow these extended special types to have "field dependencies"?
	 * f.e. the file-links transformer needs the id and filename_download to be fetched from the DB
	 * in order to work
	 */
	public transformers: Transformers = {
		async hash(operation, value) {
			if (!value) return;

			if (operation === 'create' || operation === 'update') {
				return await argon2.hash(String(value));
			}

			return value;
		},
		async uuid(operation, value) {
			if (operation === 'create' && !value) {
				return uuidv4();
			}

			return value;
		},
		async 'file-links'(operation, value, payload) {
			if (operation === 'read' && payload && payload.storage && payload.filename_disk) {
				const publicKey = `STORAGE_${payload.storage.toUpperCase()}_PUBLIC_URL`;

				return {
					asset_url: new URL(`/assets/${payload.id}`, env.PUBLIC_URL),
					public_url: new URL(payload.filename_disk, env[publicKey]),
				};
			}

			// This is an non-existing column, so there isn't any data to save
			return undefined;
		},
		async boolean(operation, value) {
			if (operation === 'read') {
				return value === true || value === 1 || value === '1';
			}

			return value;
		},
		async json(operation, value) {
			if (operation === 'read') {
				if (typeof value === 'string') {
					try {
						return JSON.parse(value);
					} catch {
						return value;
					}
				}
			}
		},
	};

	processValues(operation: Operation, payloads: Partial<Item>[]): Promise<Partial<Item>[]>;
	processValues(operation: Operation, payload: Partial<Item>): Promise<Partial<Item>>;
	async processValues(
		operation: Operation,
		payload: Partial<Item> | Partial<Item>[]
	): Promise<Partial<Item> | Partial<Item>[]> {
		const processedPayload = (Array.isArray(payload) ? payload : [payload]) as Partial<Item>[];

		if (processedPayload.length === 0) return [];

		const fieldsInPayload = Object.keys(processedPayload[0]);

		const specialFieldsQuery = this.knex
			.select('field', 'special')
			.from<FieldMeta>('directus_fields')
			.where({ collection: this.collection })
			.whereNotNull('special');

		if (operation === 'read') {
			specialFieldsQuery.whereIn('field', fieldsInPayload);
		}

		const specialFieldsInCollection = await specialFieldsQuery;

		await Promise.all(
			processedPayload.map(async (record: any) => {
				await Promise.all(
					specialFieldsInCollection.map(async (field) => {
						const newValue = await this.processField(field, record, operation);
						if (newValue !== undefined) record[field.field] = newValue;
					})
				);
			})
		);

		if (['create', 'update'].includes(operation)) {
			processedPayload.forEach((record) => {
				for (const [key, value] of Object.entries(record)) {
					if (Array.isArray(value) || (typeof value === 'object' && value !== null)) {
						record[key] = JSON.stringify(value);
					}
				}
			});
		}

		if (Array.isArray(payload)) {
			return processedPayload;
		}

		return processedPayload[0];
	}

	async processField(
		field: Pick<FieldMeta, 'field' | 'special'>,
		payload: Partial<Item>,
		operation: Operation
	) {
		if (!field.special) return payload[field.field];

		if (this.transformers.hasOwnProperty(field.special)) {
			return await this.transformers[field.special](operation, payload[field.field], payload);
		}

		return payload[field.field];
	}

	/**
	 * Recursively save/update all nested related m2o items
	 */
	processM2O(payloads: Partial<Item>[]): Promise<Partial<Item>[]>;
	processM2O(payloads: Partial<Item>): Promise<Partial<Item>>;
	async processM2O(
		payload: Partial<Item> | Partial<Item>[]
	): Promise<Partial<Item> | Partial<Item>[]> {
		const relations = await this.knex
			.select<Relation[]>('*')
			.from('directus_relations')
			.where({ many_collection: this.collection });

		const payloads = clone(Array.isArray(payload) ? payload : [payload]);

		for (let i = 0; i < payloads.length; i++) {
			let payload = payloads[i];

			// Only process related records that are actually in the payload
			const relationsToProcess = relations.filter((relation) => {
				return (
					payload.hasOwnProperty(relation.many_field) &&
					isObject(payload[relation.many_field])
				);
			});

			for (const relation of relationsToProcess) {
				const itemsService = new ItemsService(relation.one_collection, {
					accountability: this.accountability,
					knex: this.knex,
				});

				const relatedRecord: Partial<Item> = payload[relation.many_field];
				const hasPrimaryKey = relatedRecord.hasOwnProperty(relation.one_primary);

				let relatedPrimaryKey: PrimaryKey;

				if (hasPrimaryKey) {
					relatedPrimaryKey = relatedRecord[relation.one_primary];
					await itemsService.update(relatedRecord, relatedPrimaryKey);
				} else {
					relatedPrimaryKey = await itemsService.create(relatedRecord);
				}

				// Overwrite the nested object with just the primary key, so the parent level can be saved correctly
				payload[relation.many_field] = relatedPrimaryKey;
			}
		}

		return Array.isArray(payload) ? payloads : payloads[0];
	}

	/**
	 * Recursively save/update all nested related o2m items
	 */
	async processO2M(payload: Partial<Item> | Partial<Item>[], parent?: PrimaryKey) {
		const relations = await this.knex
			.select<Relation[]>('*')
			.from('directus_relations')
			.where({ one_collection: this.collection });

		const payloads = clone(Array.isArray(payload) ? payload : [payload]);

		for (let i = 0; i < payloads.length; i++) {
			let payload = payloads[i];

			// Only process related records that are actually in the payload
			const relationsToProcess = relations.filter((relation) => {
				return (
					payload.hasOwnProperty(relation.one_field) &&
					Array.isArray(payload[relation.one_field])
				);
			});

			for (const relation of relationsToProcess) {
				const relatedRecords: Partial<Item>[] = payload[relation.one_field].map(
					(record: Partial<Item>) => ({
						...record,
						[relation.many_field]: parent || payload[relation.one_primary],
					})
				);

				const itemsService = new ItemsService(relation.many_collection, {
					accountability: this.accountability,
					knex: this.knex,
				});

				const toBeCreated = relatedRecords.filter(
					(record) => record.hasOwnProperty(relation.many_primary) === false
				);

				const toBeUpdated = relatedRecords.filter(
					(record) => record.hasOwnProperty(relation.many_primary) === true && record.hasOwnProperty('$delete') === false
				);

				const toBeDeleted = relatedRecords
					.filter(record => record.hasOwnProperty(relation.many_primary) === true && record.hasOwnProperty('$delete') && record.$delete === true)
					.map(record => record[relation.many_primary]);

				await itemsService.create(toBeCreated);
				await itemsService.update(toBeUpdated);
				await itemsService.delete(toBeDeleted);
			}
		}
	}
}
