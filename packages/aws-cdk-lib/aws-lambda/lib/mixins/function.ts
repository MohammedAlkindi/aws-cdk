import type { IConstruct } from 'constructs';
import { Annotations, Token, UnscopedValidationError } from '../../../core';
import { Mixin } from '../../../core/lib/mixins';
import { lit } from '../../../core/lib/private/literal-string';
import type { ICapacityProviderRef } from '../../../interfaces/generated/aws-lambda-interfaces.generated';
import type { CapacityProviderFunctionOptions } from '../capacity-provider';
import { CfnFunction } from '../lambda.generated';

/**
 * Lambda-specific Mixin to run a function on a capacity provider.
 *
 * Accepts any capacity provider reference, so it works with capacity providers
 * created in the same app, imported with `CapacityProvider.fromCapacityProviderArn()`
 * or `CapacityProvider.fromCapacityProviderName()`, or defined as `CfnCapacityProvider`.
 *
 * Replaces any existing `CapacityProviderConfig` on the function, since a function can be
 * attached to at most one capacity provider. `PublishToLatestPublished` and
 * `FunctionScalingConfig` are only set when the corresponding options are provided.
 */
export class FunctionCapacityProvider extends Mixin {
  private readonly capacityProvider: ICapacityProviderRef;
  private readonly options: CapacityProviderFunctionOptions;

  /**
   * @param capacityProvider The capacity provider to run the function on
   * @param options Configuration for the function's capacity provider settings
   */
  constructor(capacityProvider: ICapacityProviderRef, options: CapacityProviderFunctionOptions = {}) {
    super();
    this.capacityProvider = capacityProvider;
    this.options = options;

    validateFunctionScalingConfig(
      options.latestPublishedScalingConfig?.minExecutionEnvironments,
      options.latestPublishedScalingConfig?.maxExecutionEnvironments,
    );
  }

  public supports(construct: IConstruct): construct is CfnFunction {
    return CfnFunction.isCfnFunction(construct);
  }

  public applyTo(construct: IConstruct): void {
    if (!this.supports(construct)) {
      return;
    }

    Annotations.of(construct).addInfoV2('aws-lambda:Function.CapacityProviderConfiguration', 'Capacity provider configuration cannot be removed from a function, only modified.');

    if (this.options.publishToLatestPublished !== undefined) {
      construct.publishToLatestPublished = this.options.publishToLatestPublished;
    }

    construct.capacityProviderConfig = {
      lambdaManagedInstancesCapacityProviderConfig: {
        capacityProviderArn: this.capacityProvider.capacityProviderRef.capacityProviderArn,
        perExecutionEnvironmentMaxConcurrency: this.options.perExecutionEnvironmentMaxConcurrency,
        executionEnvironmentMemoryGiBPerVCpu: this.options.executionEnvironmentMemoryGiBPerVCpu,
      },
    };

    const minExecutionEnvironments = this.options.latestPublishedScalingConfig?.minExecutionEnvironments;
    const maxExecutionEnvironments = this.options.latestPublishedScalingConfig?.maxExecutionEnvironments;

    if (minExecutionEnvironments !== undefined || maxExecutionEnvironments !== undefined) {
      construct.functionScalingConfig = {
        minExecutionEnvironments,
        maxExecutionEnvironments,
      };
    }
  }
}

function validateFunctionScalingConfig(minExecutionEnvironments?: number, maxExecutionEnvironments?: number) {
  const minDefined = minExecutionEnvironments !== undefined && !Token.isUnresolved(minExecutionEnvironments);
  const maxDefined = maxExecutionEnvironments !== undefined && !Token.isUnresolved(maxExecutionEnvironments);

  if (minDefined && (minExecutionEnvironments < 0 || minExecutionEnvironments > 15000)) {
    throw new UnscopedValidationError(lit`MinExecutionEnvironments`, `minExecutionEnvironments must be between 0 and 15000, but was ${minExecutionEnvironments}.`);
  }

  if (maxDefined && (maxExecutionEnvironments < 0 || maxExecutionEnvironments > 15000)) {
    throw new UnscopedValidationError(lit`MaxExecutionEnvironments`, `maxExecutionEnvironments must be between 0 and 15000, but was ${maxExecutionEnvironments}.`);
  }

  if (minDefined && maxDefined && minExecutionEnvironments > maxExecutionEnvironments) {
    throw new UnscopedValidationError(lit`MinExecutionEnvironmentsLessEqual`, 'minExecutionEnvironments must be less than or equal to maxExecutionEnvironments.');
  }
}
