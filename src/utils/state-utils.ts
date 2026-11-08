import { BeansMap } from "../types/types";

/** Results of the last workspace analysis. */
export default class StateUtils {

  static beans: BeansMap | undefined;

  static setResults(beans: BeansMap) {
    this.beans = beans;
  }

  static hasResults(): boolean {
    return this.beans !== undefined;
  }

}
