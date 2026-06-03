import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * The estate itself.
 *
 * MVP rule: one user, one plantation. Enforced by the unique index on
 * ownerId. The model is ready for multi-estate support later — just drop
 * the unique constraint.
 *
 * @see Developer brief §4.1
 */
const plantationSchema = new Schema(
  {
    ownerId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
      index: true,
    },
    name: { type: String, required: true, trim: true },
    district: { type: String, required: true, trim: true },
    totalAcres: { type: Number, required: true, min: 0.01 },
    primaryCrop: { type: String, default: 'Cardamom', trim: true },
  },
  { timestamps: true },
);

plantationSchema.methods.toPublicJSON = function () {
  return {
    id: this._id.toString(),
    ownerId: this.ownerId.toString(),
    name: this.name,
    district: this.district,
    totalAcres: this.totalAcres,
    primaryCrop: this.primaryCrop,
    createdAt: this.createdAt,
  };
};

export const Plantation = mongoose.model('Plantation', plantationSchema);
