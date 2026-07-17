<?php

declare(strict_types=1);

require_once __DIR__ . '/../app/Domain/MoneyAllocator.php';

use App\Domain\MoneyAllocator;

$allocator = new MoneyAllocator();
$even = $allocator->allocate(12, 3);

if ($even !== [4, 4, 4]) {
    throw new RuntimeException('Even allocation behavior regressed.');
}

foreach (glob(__DIR__ . '/Property/*.php') ?: [] as $propertyTest) {
    require $propertyTest;
}

fwrite(STDOUT, "All tests passed.\n");
