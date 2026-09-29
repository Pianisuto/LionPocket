import type {
  CatalogInput,
  GoalInput,
  InstallmentPurchaseInput,
  RecurringExpenseInput,
  TransactionFilters,
  TransactionInput,
} from '@lionpocket/core';
import { database } from './connection';
import { MobileRepository } from './repository';
const repository = async () => new MobileRepository(await database());
export const listTransactions = async (filters: TransactionFilters) =>
  (await repository()).list(filters);
export const getCatalogs = async () => (await repository()).catalogs();
export const createCatalog = async (input: CatalogInput) =>
  (await repository()).createCatalog(input);
export const saveTransaction = async (input: TransactionInput) => (await repository()).save(input);
export const deleteTransaction = async (id: string) => (await repository()).remove(id);
export const settleTransaction = async (id: string) => (await repository()).settle(id);

export const deleteCatalog = async (type: CatalogInput['type'], id: string) =>
  (await repository()).removeCatalog(type, id);
export const listRecurring = async () => (await repository()).listRecurring();
export const saveRecurring = async (input: RecurringExpenseInput) =>
  (await repository()).saveRecurring(input);
export const deleteRecurring = async (id: string) => (await repository()).removeRecurring(id);
export const listInstallments = async (month: string) =>
  (await repository()).listInstallments(month);
export const saveInstallment = async (input: InstallmentPurchaseInput) =>
  (await repository()).saveInstallment(input);
export const deleteInstallment = async (id: string) => (await repository()).removeInstallment(id);
export const listGoals = async () => (await repository()).listGoals();
export const saveGoal = async (input: GoalInput) => (await repository()).saveGoal(input);
export const deleteGoal = async (id: string) => (await repository()).removeGoal(id);
export const settleTransactions = async (ids: string[]) => (await repository()).settleMany(ids);
