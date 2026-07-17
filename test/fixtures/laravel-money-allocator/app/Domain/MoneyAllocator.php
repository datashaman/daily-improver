<?php

declare(strict_types=1);

namespace App\Domain;

final class MoneyAllocator
{
    /**
     * @return list<int>
     */
    public function allocate(int $total, int $parts): array
    {
        if ($total < 0) {
            throw new \InvalidArgumentException('Total must be non-negative.');
        }

        if ($parts < 1) {
            throw new \InvalidArgumentException('Parts must be positive.');
        }

        $share = intdiv($total, $parts);

        return array_fill(0, $parts, $share);
    }
}
